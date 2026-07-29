import { describe, expect, it } from "vitest";

import { runFourBrainOfflineEconomicReport } from "../src/lib/four-brain-offline-economic-report.js";
import type { FourBrainPolicyContext } from "../src/lib/four-brain-economic-experience.js";
import type { ExecutiveReviewOutcome } from "../src/lib/executive-review-store.js";
import type { DirectionDecision, EntryDecision, MarketStateDecision } from "../src/lib/four-brain-types.js";

const DAY_MS = 86_400_000;
const POLICY: FourBrainPolicyContext = {
  instanceId: "3101",
  decisionPipelinePolicyVersion: "pipeline/v2",
  executionPolicyVersion: "execution/v2",
  evidencePolicyVersion: "evidence/v2",
  evidenceEra: "post-fix/2",
  fourBrainPolicyVersion: "executive/2",
  policyDeploymentAt: "2026-07-29T00:00:00.000Z",
};
const DEPLOY_MS = Date.parse(POLICY.policyDeploymentAt);
const NOW_MS = DEPLOY_MS + 90 * DAY_MS;

const marketState = (): MarketStateDecision => ({
  schemaVersion: "market-state/1", decisionId: "ms-1", asOfMs: 0, validUntilMs: 1,
  family: "TREND", bias: "BULLISH", volatility: "NORMAL", liquidity: "NORMAL", transitionRisk: 0.1, confidence: 0.8,
  components: { trendScore: 0.4, volatilityScore: null, liquidityScore: null, breadthScore: null, momentumScore: null, eventRiskScore: null, sentimentScore: null },
  reasons: [], sourceStatuses: {},
});
const direction = (): DirectionDecision => ({
  schemaVersion: "direction/1", decisionId: "dir-1", asOfMs: 0, validUntilMs: 1, horizon: "INTRADAY", modelScope: "MARKET_LEVEL", evaluationHorizon: "INTRADAY",
  marketDirection: "LONG", action: "LONG", longScore: 0.8, shortScore: 0.1, flatScore: 0.1, confidence: 0.8, directionConfidence: 0.8, dataCoverage: 1,
  directionEvidenceFamilies: {
    marketStructure: { available: true, contribution: 0.5, credibilityPenalty: 0, reasons: [] },
    incumbentEconomic: { available: false, contribution: null, credibilityPenalty: null, reasons: [] },
    externalForecasts: { available: false, contribution: null, credibilityPenalty: null, reasons: [] },
    flow: { available: false, contribution: null, credibilityPenalty: null, reasons: [] },
    selfEvidence: { available: false, contribution: null, credibilityPenalty: null, reasons: [] },
  },
  expectedDirectionalR: 0.3, supportingSignals: [], conflictingSignals: [], sourceStatuses: {},
});
const entry = (): EntryDecision => ({
  schemaVersion: "entry/1", decisionId: "entry-1", asOfMs: 0, validUntilMs: 1, action: "ENTER_NOW", side: "LONG", orderType: "MARKET",
  targetEntry: 65_000, invalidationPrice: 64_000, initialStopPrice: 64_000, expectedNetR: 0.3, chaseRisk: 0.1, slippageRisk: 0.1, confidence: 0.8,
  reasons: [], sourceStatuses: {},
});

function outcome(dayIndex: number, netR: number, laneId = "CG_WIDE_FAST_LONG"): ExecutiveReviewOutcome {
  // +1 day buffer so even dayIndex=0's executiveDecisionTimeMs (entryAtMs - 60s) stays safely after
  // the cutover instant, rather than landing exactly on it.
  const entryAtMs = DEPLOY_MS + (dayIndex + 1) * DAY_MS;
  const resolvedAtMs = entryAtMs + 60_000;
  return {
    executiveReviewOutcomeId: `outcome:${laneId}:${dayIndex}`,
    executiveReviewId: `executive-review:exec-${laneId}-${dayIndex}:opp-${laneId}-${dayIndex}`,
    tier: "TIER_1_REAL",
    candidateId: `candidate-${dayIndex}`,
    opportunityId: `opp-${laneId}-${dayIndex}`,
    executionIntentId: `intent-${dayIndex}`,
    orderId: `order-${dayIndex}`,
    positionId: `position-${dayIndex}`,
    outcomeId: `outcome-${laneId}-${dayIndex}`,
    marketContextSnapshotId: "snapshot-1",
    allocationSnapshotId: null,
    laneId,
    direction: "LONG",
    marketState: "TREND",
    evidenceEra: POLICY.evidenceEra,
    strategyAction: "ENTER",
    advisoryVerdict: "VALID",
    incumbentAction: "ENTERED",
    advisoryOnly: true,
    entryAtMs,
    resolvedAtMs,
    originalRisk: 100,
    grossR: netR + 0.02,
    costR: 0.02,
    netR,
    executionCostProvenance: "EXCHANGE_MEASURED",
    settlementFetchComplete: true,
    requiredOrderIds: ["order-1"],
    matchedRequiredOrderIds: ["order-1"],
    missingRequiredOrderIds: [],
    decisionPipelinePolicyVersion: POLICY.decisionPipelinePolicyVersion,
    executionPolicyVersion: POLICY.executionPolicyVersion,
    evidencePolicyVersion: POLICY.evidencePolicyVersion,
    fourBrainPolicyVersion: POLICY.fourBrainPolicyVersion,
    eligibleForFourBrainEvaluation: true,
    eligibleForCortexLearning: false,
    executiveDecisionId: `exec-${laneId}-${dayIndex}`,
    instanceId: "3101",
    symbolOrBasketId: "BTCUSDT",
    policyDeploymentAt: POLICY.policyDeploymentAt,
    executiveDecisionTimeMs: entryAtMs - 60_000,
    marketStateDecision: marketState(),
    directionDecision: direction(),
    entryDecision: entry(),
    brainFeatureSnapshot: { trendScore: 0.4 },
    brainFeatureSchemaVersions: { executive: "executive/2" },
    sourceStatuses: { trend: "FRESH" },
    exactCloseTimeMs: resolvedAtMs,
  };
}

describe("Four-Brain offline economic report orchestration", () => {
  it("proves outcomes -> experiences -> per-brain/per-lane reports, with Exit always present alongside", () => {
    const outcomes = Array.from({ length: 40 }, (_, i) => outcome(i, i % 5 === 0 ? -0.03 : 0.05));
    const result = runFourBrainOfflineEconomicReport({ outcomes, expectedPolicy: POLICY, nowMs: NOW_MS });

    expect(result.totalExperiences).toBe(40 * 3); // MarketState + Direction + Entry per outcome
    expect(result.directLearningEligibleCount).toBe(40 * 3);
    expect(result.evaluationOnlyCount).toBe(0);
    expect(Object.values(result.rejected).reduce((a, b) => a + b, 0)).toBe(0);

    const brains = new Set(result.laneReports.map((r) => r.brain));
    expect(brains).toEqual(new Set(["MARKET_STATE", "DIRECTION", "ENTRY", "EXIT"]));
    const exitReport = result.laneReports.find((r) => r.brain === "EXIT" && r.laneId === "CG_WIDE_FAST_LONG");
    expect(exitReport?.evidenceStatus).toBe("EVALUATION_ONLY");
    expect(result.exitStatus.eligibility).toBe("INELIGIBLE");
  });

  it("groups separately by lane — one lane's evidence never blends into another's report", () => {
    const outcomes = [
      ...Array.from({ length: 5 }, (_, i) => outcome(i, 0.05, "LANE_A")),
      ...Array.from({ length: 5 }, (_, i) => outcome(i, -0.05, "LANE_B")),
    ];
    const result = runFourBrainOfflineEconomicReport({ outcomes, expectedPolicy: POLICY, nowMs: NOW_MS });
    const entryLaneA = result.laneReports.find((r) => r.brain === "ENTRY" && r.laneId === "LANE_A")!;
    const entryLaneB = result.laneReports.find((r) => r.brain === "ENTRY" && r.laneId === "LANE_B")!;
    expect(entryLaneA.positiveCount).toBe(5);
    expect(entryLaneA.negativeCount).toBe(0);
    expect(entryLaneB.positiveCount).toBe(0);
    expect(entryLaneB.negativeCount).toBe(5);
  });

  it("propagates rejection counts from the adapter untouched", () => {
    const badOutcome = { ...outcome(0, 0.05), originalRisk: 0 };
    const result = runFourBrainOfflineEconomicReport({ outcomes: [badOutcome], expectedPolicy: POLICY, nowMs: NOW_MS });
    expect(result.totalExperiences).toBe(0);
    expect(result.rejected.MISSING_IMMUTABLE_RISK).toBe(1);
    expect(result.laneReports).toHaveLength(0); // no lane was ever observed
  });

  it("is a pure function — running it twice on the same input yields the same result", () => {
    const outcomes = Array.from({ length: 35 }, (_, i) => outcome(i, 0.05));
    const first = runFourBrainOfflineEconomicReport({ outcomes, expectedPolicy: POLICY, nowMs: NOW_MS });
    const second = runFourBrainOfflineEconomicReport({ outcomes, expectedPolicy: POLICY, nowMs: NOW_MS });
    expect(second).toEqual(first);
  });
});

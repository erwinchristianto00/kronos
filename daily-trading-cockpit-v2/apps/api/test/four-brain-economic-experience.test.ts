import { describe, expect, it } from "vitest";

import {
  FOUR_BRAIN_ECONOMIC_SCHEMA_VERSION,
  buildFourBrainExecutiveExperiences,
  executiveDecisionIdFromReviewId,
  fourBrainExitAttributionStatus,
  type FourBrainEconomicRejectionReason,
  type FourBrainPolicyContext,
} from "../src/lib/four-brain-economic-experience.js";
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
const NOW_MS = DEPLOY_MS + 10 * DAY_MS;

function marketStateDecision(overrides: Partial<MarketStateDecision> = {}): MarketStateDecision {
  return {
    schemaVersion: "market-state/1",
    decisionId: "ms-1",
    asOfMs: DEPLOY_MS + DAY_MS - 60_000,
    validUntilMs: DEPLOY_MS + DAY_MS,
    family: "TREND",
    bias: "BULLISH",
    volatility: "NORMAL",
    liquidity: "NORMAL",
    transitionRisk: 0.1,
    confidence: 0.8,
    components: { trendScore: 0.4, volatilityScore: 0.2, liquidityScore: 0.3, breadthScore: null, momentumScore: null, eventRiskScore: null, sentimentScore: null },
    reasons: [],
    sourceStatuses: { trend: "FRESH" },
    ...overrides,
  };
}

function directionDecision(overrides: Partial<DirectionDecision> = {}): DirectionDecision {
  return {
    schemaVersion: "direction/1",
    decisionId: "dir-1",
    asOfMs: DEPLOY_MS + DAY_MS - 60_000,
    validUntilMs: DEPLOY_MS + DAY_MS,
    horizon: "INTRADAY",
    modelScope: "MARKET_LEVEL",
    evaluationHorizon: "INTRADAY",
    marketDirection: "LONG",
    action: "LONG",
    longScore: 0.8,
    shortScore: 0.1,
    flatScore: 0.1,
    confidence: 0.8,
    directionConfidence: 0.8,
    dataCoverage: 1,
    directionEvidenceFamilies: {
      marketStructure: { available: true, contribution: 0.5, credibilityPenalty: 0, reasons: [] },
      incumbentEconomic: { available: true, contribution: 0.3, credibilityPenalty: 0, reasons: [] },
      externalForecasts: { available: false, contribution: null, credibilityPenalty: null, reasons: [] },
      flow: { available: false, contribution: null, credibilityPenalty: null, reasons: [] },
      selfEvidence: { available: false, contribution: null, credibilityPenalty: null, reasons: [] },
    },
    expectedDirectionalR: 0.3,
    supportingSignals: [],
    conflictingSignals: [],
    sourceStatuses: { trend: "FRESH" },
    ...overrides,
  };
}

function entryDecision(overrides: Partial<EntryDecision> = {}): EntryDecision {
  return {
    schemaVersion: "entry/1",
    decisionId: "entry-1",
    asOfMs: DEPLOY_MS + DAY_MS - 60_000,
    validUntilMs: DEPLOY_MS + DAY_MS,
    action: "ENTER_NOW",
    side: "LONG",
    orderType: "MARKET",
    targetEntry: 65_000,
    invalidationPrice: 64_000,
    initialStopPrice: 64_000,
    expectedNetR: 0.3,
    chaseRisk: 0.1,
    slippageRisk: 0.1,
    confidence: 0.8,
    reasons: [],
    sourceStatuses: { candle: "FRESH" },
    ...overrides,
  };
}

function validOutcome(overrides: Partial<ExecutiveReviewOutcome> = {}): ExecutiveReviewOutcome {
  const entryAtMs = DEPLOY_MS + DAY_MS;
  const resolvedAtMs = entryAtMs + 60_000;
  return {
    executiveReviewOutcomeId: "executive-review-outcome:1",
    executiveReviewId: "executive-review:exec-1:opp-1",
    tier: "TIER_1_REAL",
    candidateId: "candidate-1",
    opportunityId: "opp-1",
    executionIntentId: "intent-1",
    orderId: "order-1",
    positionId: "position-1",
    outcomeId: "outcome-1",
    marketContextSnapshotId: "snapshot-1",
    allocationSnapshotId: null,
    laneId: "CG_WIDE_FAST_LONG",
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
    grossR: 0.5,
    costR: 0.05,
    executionCostProvenance: "EXCHANGE_MEASURED",
    settlementFetchComplete: true,
    requiredOrderIds: ["order-1"],
    matchedRequiredOrderIds: ["order-1"],
    missingRequiredOrderIds: [],
    netR: 0.45,
    decisionPipelinePolicyVersion: POLICY.decisionPipelinePolicyVersion,
    executionPolicyVersion: POLICY.executionPolicyVersion,
    evidencePolicyVersion: POLICY.evidencePolicyVersion,
    fourBrainPolicyVersion: POLICY.fourBrainPolicyVersion,
    eligibleForFourBrainEvaluation: true,
    eligibleForCortexLearning: false,
    executiveDecisionId: "exec-1",
    instanceId: "3101",
    symbolOrBasketId: "BTCUSDT",
    policyDeploymentAt: POLICY.policyDeploymentAt,
    executiveDecisionTimeMs: entryAtMs - 60_000,
    marketStateDecision: marketStateDecision(),
    directionDecision: directionDecision(),
    entryDecision: entryDecision(),
    brainFeatureSnapshot: { trendScore: 0.4 },
    brainFeatureSchemaVersions: { executive: "executive/2" },
    sourceStatuses: { trend: "FRESH" },
    exactCloseTimeMs: resolvedAtMs,
    ...overrides,
  };
}

function run(outcome: ExecutiveReviewOutcome, policy: FourBrainPolicyContext = POLICY) {
  return buildFourBrainExecutiveExperiences([outcome], policy, NOW_MS);
}

describe("Four-Brain economic experience adapter (hardened)", () => {
  it("exact valid chain: all three brains reach DIRECT_LEARNING_ELIGIBLE from one resolved review", () => {
    const result = run(validOutcome());
    expect(result.experiences).toHaveLength(3);
    for (const experience of result.experiences) {
      expect(experience.attributionEligibility).toBe("DIRECT_LEARNING_ELIGIBLE");
      expect(experience.evaluationOnlyReasons).toEqual([]);
      expect(experience.economicClass).toBe("POSITIVE");
      expect(experience.schemaVersion).toBe(FOUR_BRAIN_ECONOMIC_SCHEMA_VERSION);
    }
    expect(Object.values(result.rejected).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("preserves continuous fractional netR exactly", () => {
    const outcome = validOutcome({ grossR: 0.173456, costR: 0.02, netR: 0.153456 });
    const result = run(outcome);
    for (const experience of result.experiences) expect(experience.netR).toBeCloseTo(0.153456, 9);
  });

  it("decodes the executive decisionId embedded in the legacy executiveReviewId construction (diagnostic use only)", () => {
    expect(executiveDecisionIdFromReviewId("executive-review:exec-1:opp-1", "opp-1")).toBe("exec-1");
    expect(executiveDecisionIdFromReviewId("executive-review:exec-1:opp-1", "wrong-opportunity")).toBeNull();
  });

  describe("exact policy/cohort context", () => {
    it("rejects a wrong-instance outcome even with otherwise-correct policy versions", () => {
      const outcome = validOutcome({ instanceId: "3102" });
      const result = run(outcome, POLICY); // POLICY expects 3101
      expect(result.experiences).toHaveLength(0);
      expect(result.rejected.IDENTITY_MISMATCH).toBe(1);
    });

    it("never combines 3101 and 3102 — the same outcome set yields opposite results under each instance context", () => {
      const outcome3101 = validOutcome({ instanceId: "3101" });
      const resultAs3101 = run(outcome3101, { ...POLICY, instanceId: "3101" });
      expect(resultAs3101.experiences).toHaveLength(3);
      const resultAs3102 = run(outcome3101, { ...POLICY, instanceId: "3102" });
      expect(resultAs3102.experiences).toHaveLength(0);
      expect(resultAs3102.rejected.IDENTITY_MISMATCH).toBe(1);
    });

    it("rejects stale policy versions (a different 4/5-tuple than the expected current one)", () => {
      const outcome = validOutcome({ fourBrainPolicyVersion: "executive/1" });
      const result = run(outcome);
      expect(result.experiences).toHaveLength(0);
      expect(result.rejected.STALE_POLICY_CONTEXT).toBe(1);
    });

    it("rejects same policy versions but a decision/entry time before the cutover (PRE_CUTOVER)", () => {
      const laterCutover = new Date(DEPLOY_MS + 5 * DAY_MS).toISOString();
      const result = run(validOutcome(), { ...POLICY, policyDeploymentAt: laterCutover });
      expect(result.experiences).toHaveLength(0);
      expect(result.rejected.PRE_CUTOVER).toBe(1);
      expect(result.rejected.STALE_POLICY_CONTEXT).toBe(0);
    });

    it("rejects a future policyDeploymentAt as a malformed/untrustworthy cutover", () => {
      const futureCutover = new Date(NOW_MS + DAY_MS).toISOString();
      const result = run(validOutcome({ policyDeploymentAt: futureCutover }), { ...POLICY, policyDeploymentAt: futureCutover });
      expect(result.experiences).toHaveLength(0);
      expect(result.rejected.STALE_POLICY_CONTEXT).toBe(1);
    });

    it("this source has no separate PRE_CUTOVER field on legacy records — an unstamped record is EVALUATION_ONLY via LEGACY_UNSTAMPED_RECORD, not a hard PRE_CUTOVER rejection", () => {
      const legacy = validOutcome({ executiveDecisionId: null, instanceId: null, policyDeploymentAt: null, executiveDecisionTimeMs: null });
      const result = run(legacy);
      expect(result.experiences.length).toBeGreaterThan(0);
      expect(result.rejected.PRE_CUTOVER).toBe(0);
      for (const experience of result.experiences) {
        expect(experience.attributionEligibility).toBe("EVALUATION_ONLY");
        expect(experience.evaluationOnlyReasons).toContain("LEGACY_UNSTAMPED_RECORD");
      }
    });
  });

  describe("causal clocks", () => {
    it("uses the persisted executiveDecisionTimeMs, never review.reviewedAtMs (which no longer even exists on this merged type)", () => {
      const distinctDecisionTimeMs = DEPLOY_MS + DAY_MS - 12_345;
      const outcome = validOutcome({ executiveDecisionTimeMs: distinctDecisionTimeMs });
      const result = run(outcome);
      for (const experience of result.experiences) expect(experience.decisionTimeMs).toBe(distinctDecisionTimeMs);
    });

    it("accepts the exact persisted decision time end-to-end (direct-learning eligible)", () => {
      const result = run(validOutcome());
      expect(result.experiences[0]!.attributionEligibility).toBe("DIRECT_LEARNING_ELIGIBLE");
    });

    it("a missing exact close time caps eligibility at EVALUATION_ONLY rather than silently substituting resolvedAtMs", () => {
      const outcome = validOutcome({ exactCloseTimeMs: null });
      const result = run(outcome);
      expect(result.experiences.length).toBeGreaterThan(0);
      for (const experience of result.experiences) {
        expect(experience.attributionEligibility).toBe("EVALUATION_ONLY");
        expect(experience.evaluationOnlyReasons).toContain("MISSING_EXACT_CLOSE_TIME");
        // The economic class is still computed from a best-effort clock (never thrown away)...
        expect(experience.economicClass).not.toBe("INVALID");
        // ...but that best-effort value is never claimed to be the exact close time.
        expect(experience.closedTimeMs).toBe(outcome.resolvedAtMs);
      }
    });

    it("a persisted feature snapshot surviving independently of any journal proves the journal-retention gap is closed", () => {
      // No journal object is ever passed to this adapter — feature availability depends only on
      // whether admission captured brainFeatureSnapshot on the outcome itself.
      const result = run(validOutcome());
      expect(result.experiences.every((e) => e.attributionEligibility === "DIRECT_LEARNING_ELIGIBLE")).toBe(true);
    });

    it("a missing persisted feature snapshot is EVALUATION_ONLY, not silently dropped", () => {
      const outcome = validOutcome({ brainFeatureSnapshot: null });
      const result = run(outcome);
      expect(result.experiences.length).toBeGreaterThan(0);
      for (const experience of result.experiences) {
        expect(experience.attributionEligibility).toBe("EVALUATION_ONLY");
        expect(experience.evaluationOnlyReasons).toContain("MISSING_FEATURE_SNAPSHOT");
      }
    });
  });

  describe("economic adapter (hard gates, unchanged)", () => {
    const rejectionCase = (
      name: string,
      mutate: (o: ExecutiveReviewOutcome) => ExecutiveReviewOutcome,
      expectedReason: FourBrainEconomicRejectionReason,
    ) =>
      it(name, () => {
        const result = run(mutate(validOutcome()));
        expect(result.experiences).toHaveLength(0);
        expect(result.rejected[expectedReason]).toBeGreaterThan(0);
      });

    rejectionCase("missing immutable risk is rejected", (o) => ({ ...o, originalRisk: 0 }), "MISSING_IMMUTABLE_RISK");
    rejectionCase("non-finite immutable risk is rejected", (o) => ({ ...o, originalRisk: Number.NaN }), "MISSING_IMMUTABLE_RISK");
    rejectionCase("incomplete settlement is rejected", (o) => ({ ...o, missingRequiredOrderIds: ["order-2"] }), "INCOMPLETE_COST");
    rejectionCase("negative canonical cost is rejected", (o) => ({ ...o, costR: -0.05, grossR: 0.4, netR: 0.45 }), "INVALID_COST_CONVENTION");
    rejectionCase("an arithmetic mismatch is rejected", (o) => ({ ...o, grossR: 1.0, costR: 0.05, netR: 0.9 }), "ECONOMIC_ARITHMETIC_MISMATCH");
    rejectionCase("resolvedAtMs before entryAtMs is rejected", (o) => ({ ...o, resolvedAtMs: o.entryAtMs - 1 }), "INVALID_OUTCOME_QUALITY");

    it("unresolved is never counted as negative", () => {
      const result = run({ ...validOutcome(), resolvedAtMs: 0 as unknown as number });
      expect(result.experiences).toHaveLength(0);
      expect(result.rejected.UNRESOLVED).toBe(1);
    });

    it("non-Tier-1 or non-eligible rows are counted as SOURCE_ERROR, never silently dropped", () => {
      const result = run({ ...validOutcome(), tier: "TIER_2_COUNTERFACTUAL" as never });
      expect(result.experiences).toHaveLength(0);
      expect(result.rejected.SOURCE_ERROR).toBe(1);
    });

    it("intrabarAmbiguous is always false (real exchange-settled fills, never a simulated candle-walk)", () => {
      for (const experience of run(validOutcome()).experiences) expect(experience.intrabarAmbiguous).toBe(false);
    });
  });

  describe("brain-level attribution — object presence alone is insufficient", () => {
    it("Market State is EVALUATION_ONLY when its own decision object is absent, without affecting Direction/Entry", () => {
      const result = run(validOutcome({ marketStateDecision: null }));
      const byBrain = new Map(result.experiences.map((e) => [e.brain, e]));
      expect(byBrain.get("MARKET_STATE")!.attributionEligibility).toBe("EVALUATION_ONLY");
      expect(byBrain.get("MARKET_STATE")!.evaluationOnlyReasons).toContain("BRAIN_DECISION_ABSENT");
      expect(byBrain.get("DIRECTION")!.attributionEligibility).toBe("DIRECT_LEARNING_ELIGIBLE");
      expect(byBrain.get("ENTRY")!.attributionEligibility).toBe("DIRECT_LEARNING_ELIGIBLE");
    });

    it("Direction object present but its OWN call disagrees with the realized outcome direction is not directly eligible", () => {
      const result = run(validOutcome({ directionDecision: directionDecision({ marketDirection: "SHORT" }) }));
      const byBrain = new Map(result.experiences.map((e) => [e.brain, e]));
      expect(byBrain.get("DIRECTION")!.attributionEligibility).toBe("EVALUATION_ONLY");
      expect(byBrain.get("DIRECTION")!.evaluationOnlyReasons).toContain("BRAIN_DECISION_INEXACT");
      expect(byBrain.get("ENTRY")!.attributionEligibility).toBe("DIRECT_LEARNING_ELIGIBLE");
    });

    it("Entry object present but its side disagrees with the realized outcome direction is not directly eligible", () => {
      const result = run(validOutcome({ entryDecision: entryDecision({ side: "SHORT" }) }));
      const byBrain = new Map(result.experiences.map((e) => [e.brain, e]));
      expect(byBrain.get("ENTRY")!.attributionEligibility).toBe("EVALUATION_ONLY");
      expect(byBrain.get("ENTRY")!.evaluationOnlyReasons).toContain("BRAIN_DECISION_INEXACT");
    });

    it("Entry object present but missing an exact price/stop snapshot is not directly eligible", () => {
      const result = run(validOutcome({ entryDecision: entryDecision({ targetEntry: null }) }));
      const byBrain = new Map(result.experiences.map((e) => [e.brain, e]));
      expect(byBrain.get("ENTRY")!.attributionEligibility).toBe("EVALUATION_ONLY");
      expect(byBrain.get("ENTRY")!.evaluationOnlyReasons).toContain("BRAIN_DECISION_INEXACT");
    });

    it("Entry object present but not an ENTER_NOW action is not directly eligible", () => {
      const result = run(validOutcome({ entryDecision: entryDecision({ action: "WAIT_PULLBACK" }) }));
      const byBrain = new Map(result.experiences.map((e) => [e.brain, e]));
      expect(byBrain.get("ENTRY")!.attributionEligibility).toBe("EVALUATION_ONLY");
    });

    it("when the outcome itself fails a hard gate, no brain gets any experience at all", () => {
      const result = run(validOutcome({ originalRisk: 0 }));
      expect(result.experiences).toHaveLength(0);
    });
  });

  describe("Exit Brain — no outcome ledger exists", () => {
    it("returns INELIGIBLE with an explicit, non-empty list of missing fields rather than fabricating attribution", () => {
      const status = fourBrainExitAttributionStatus();
      expect(status.brain).toBe("EXIT");
      expect(status.eligibility).toBe("INELIGIBLE");
      expect(status.missingFields.length).toBeGreaterThan(0);
    });
  });
});

import { describe, expect, it } from "vitest";
import { normalizeExperience, candidateLearningRows } from "../src/experience-engine/experience-engine.js";
import { eligibilityFor, isDirectTrainingForbidden } from "../src/simulation/simulation-provenance.js";

const complete = {
  experienceId: "real-1", source: "OBSERVED_SHADOW_OUTCOME" as const, provenance: "OBSERVED" as const,
  decisionId: "decision-real-1", opportunityId: "opportunity-real-1", outcomeId: "outcome-real-1",
  decisionTimeMs: 1_000, openedTimeMs: 2_000, policyDeploymentAt: "1970-01-01T00:00:00.500Z", marketCloseTimeMs: 3_000, resolvedTimeMs: 4_000, laneId: "lane", symbolOrBasketId: "BTCUSDT", direction: "LONG" as const,
  featureSchemaVersion: "v1", codeVersion: "c1", featureVector: [1, 0], sourceStatuses: { price: "FRESH" as const }, attributionStatus: "ATTRIBUTED" as const,
  outcomeQuality: "RESOLVED_VALID" as const, outcomeNetR: 0.2, labels: {}, executionLabelKind: "PAPER_OUTCOME" as const,
};

describe("Real-Data Experience Engine firewall", () => {
  it("admits only complete causal real-data records", () => {
    expect(normalizeExperience(complete).eligibility).toBe("CANDIDATE_LEARNING_ELIGIBLE");
    expect(normalizeExperience({ ...complete, decisionTimeMs: 3 }).eligibility).toBe("INELIGIBLE_FOR_DIRECT_TRAINING");
  });
  it("rejects observed evidence from before its deployment boundary", () => {
    expect(normalizeExperience({ ...complete, decisionTimeMs: 400 }).eligibilityReasons).toContain("decision_before_policy_deployment");
    expect(normalizeExperience({ ...complete, openedTimeMs: 400 }).eligibilityReasons).toContain("open_before_policy_deployment");
    expect(normalizeExperience(complete).eligibility).toBe("CANDIDATE_LEARNING_ELIGIBLE");
  });
  it("permanently rejects simulated stress from candidate exports", () => {
    const stress = normalizeExperience({ ...complete, experienceId: "sim-1", source: "SIMULATED_STRESS" as const, provenance: "SIMULATED" as const });
    expect(stress.eligibility).toBe("INELIGIBLE_FOR_DIRECT_TRAINING");
    expect(candidateLearningRows([normalizeExperience(complete), stress])).toHaveLength(1);
    expect(isDirectTrainingForbidden(eligibilityFor("EMPIRICALLY_CALIBRATED"))).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { auditLineage, type DecisionSnapshot, type OpportunityOutcome } from "../src/experience-engine/lineage-auditor.js";

const decision: DecisionSnapshot = { decisionId: "decision-1", signalOrderId: "signal-1", asOfMs: 100, laneId: "lane", symbolOrBasketId: "BTCUSDT", direction: "LONG", codeVersion: "v1", features: { featureSchemaVersion: "f1", values: [1], availableAtMs: [100], sourceStatuses: { price: "FRESH" } }, sourcePointer: "fixture:decision" };
const outcome: OpportunityOutcome = { outcomeId: "outcome-1", decisionLinkId: "signal-1", source: "OBSERVED_SHADOW_OUTCOME", openedAtMs: 120, closedAtMs: 180, resolvedAtMs: 190, laneId: "lane", symbolOrBasketId: "BTCUSDT", direction: "LONG", featureSchemaVersion: "f1", outcomeNetR: 0.2, outcomeQuality: "RESOLVED_VALID", sourcePointer: "fixture:outcome" };

describe("lineage auditor", () => {
  it("proves a fixture-backed golden causal chain", () => expect(auditLineage(outcome, [decision], new Set()).rejectionReason).toBe("COMPLETE_CAUSAL_CHAIN"));
  it("rejects future feature usage and duplicate outcomes", () => {
    expect(auditLineage({ ...outcome, openedAtMs: 90 }, [decision], new Set()).rejectionReason).toBe("FUTURE_FEATURE_LEAKAGE");
    expect(auditLineage(outcome, [decision], new Set([outcome.outcomeId])).rejectionReason).toBe("DUPLICATE_OUTCOME");
  });
});

import { describe, expect, it } from "vitest";

import {
  FOUR_BRAIN_ECONOMIC_SCHEMA_VERSION,
  buildFourBrainExecutiveExperiences,
  executiveDecisionIdFromReviewId,
  fourBrainExitAttributionStatus,
  type FourBrainEconomicRejectionReason,
} from "../src/lib/four-brain-economic-experience.js";
import type { ExecutiveReviewOutcome, ExecutiveReviewRecord } from "../src/lib/executive-review-store.js";
import type { ExecutiveJournalRow } from "../src/lib/four-brain-journal.js";

const POLICY = {
  decisionPipelinePolicyVersion: "pipeline/v2",
  executionPolicyVersion: "execution/v2",
  evidencePolicyVersion: "evidence/v2",
  fourBrainPolicyVersion: "executive/2",
};

const EXEC_DECISION_ID = "exec-dec-123";
const OPPORTUNITY_ID = "opportunity-abc";
const EXECUTIVE_REVIEW_ID = `executive-review:${EXEC_DECISION_ID}:${OPPORTUNITY_ID}`;

function validReview(overrides: Partial<ExecutiveReviewRecord> = {}): ExecutiveReviewRecord {
  return {
    executiveReviewId: EXECUTIVE_REVIEW_ID,
    candidateId: "candidate-1",
    opportunityId: OPPORTUNITY_ID,
    laneId: "CG_WIDE_FAST_LONG",
    marketContextSnapshotId: "snapshot-1",
    allocationSnapshotId: null,
    strategyAction: "ENTER",
    direction: "LONG",
    marketState: "TREND",
    evidenceEra: "POST_END_TO_END_CORRECTNESS_FIX_V2",
    advisoryVerdict: "VALID",
    advisoryOnly: true,
    reviewedAtMs: 1_000,
    sourceCutoffMs: 500,
    ...POLICY,
    state: "TIER1_ELIGIBLE",
    reasonCode: null,
    positionId: "position-1",
    outcomeId: "outcome-1",
    ...overrides,
  };
}

function validOutcome(overrides: Partial<ExecutiveReviewOutcome> = {}): ExecutiveReviewOutcome {
  return {
    executiveReviewOutcomeId: "executive-review-outcome:1",
    executiveReviewId: EXECUTIVE_REVIEW_ID,
    tier: "TIER_1_REAL",
    candidateId: "candidate-1",
    opportunityId: OPPORTUNITY_ID,
    executionIntentId: "intent-1",
    orderId: "order-1",
    positionId: "position-1",
    outcomeId: "outcome-1",
    marketContextSnapshotId: "snapshot-1",
    allocationSnapshotId: null,
    laneId: "CG_WIDE_FAST_LONG",
    direction: "LONG",
    marketState: "TREND",
    evidenceEra: "POST_END_TO_END_CORRECTNESS_FIX_V2",
    strategyAction: "ENTER",
    advisoryVerdict: "VALID",
    incumbentAction: "ENTERED",
    advisoryOnly: true,
    entryAtMs: 2_000,
    resolvedAtMs: 3_000,
    originalRisk: 100,
    grossR: 0.5,
    costR: 0.05,
    executionCostProvenance: "EXCHANGE_MEASURED",
    settlementFetchComplete: true,
    requiredOrderIds: ["order-1"],
    matchedRequiredOrderIds: ["order-1"],
    missingRequiredOrderIds: [],
    netR: 0.45,
    ...POLICY,
    eligibleForFourBrainEvaluation: true,
    eligibleForCortexLearning: false,
    ...overrides,
  };
}

function validJournalRow(overrides: Partial<Record<string, unknown>> = {}): ExecutiveJournalRow {
  const raw: Record<string, unknown> = {
    kind: "EXECUTIVE_DECISION",
    reportOnly: true,
    schemaVersions: { executive: "executive/2", marketState: "market-state/1", direction: "direction/1", entry: "entry/1", exit: null },
    decisionIds: { executive: EXEC_DECISION_ID },
    laneId: "CG_WIDE_FAST_LONG",
    symbolOrBasketId: "BTCUSDT",
    candidateStatus: "VALID",
    wouldAct: true,
    sourceStatuses: { trend: "FRESH", liquidity: "FRESH" },
    normalizedFeatures: { trendScore: 0.4, momentumScore: 0.2 },
    rawFeatures: { trendScoreRaw: 0.41 },
    brains: {
      marketState: { family: "TREND" },
      direction: { marketDirection: "LONG" },
      entry: { action: "ENTER_NOW" },
      exit: null,
    },
    ...overrides,
  };
  return {
    decisionId: EXEC_DECISION_ID,
    asOfMs: 1_000,
    candidateStatus: "VALID",
    wouldAct: true,
    laneId: "CG_WIDE_FAST_LONG",
    symbolOrBasketId: "BTCUSDT",
    disagreements: [],
    raw,
  };
}

function journalMap(...rows: ExecutiveJournalRow[]): Map<string, ExecutiveJournalRow> {
  return new Map(rows.map((row) => [row.decisionId, row]));
}

describe("Four-Brain economic experience adapter", () => {
  it("exact valid chain: builds MarketState, Direction, and Entry experiences from one resolved Tier-1 review", () => {
    const result = buildFourBrainExecutiveExperiences([validOutcome()], [validReview()], journalMap(validJournalRow()), POLICY);
    expect(result.experiences).toHaveLength(3);
    const brains = result.experiences.map((e) => e.brain).sort();
    expect(brains).toEqual(["DIRECTION", "ENTRY", "MARKET_STATE"]);
    for (const experience of result.experiences) {
      expect(experience.attributionEligibility).toBe("DIRECT_LEARNING_ELIGIBLE");
      expect(experience.economicClass).toBe("POSITIVE");
      expect(experience.schemaVersion).toBe(FOUR_BRAIN_ECONOMIC_SCHEMA_VERSION);
      expect(experience.executiveDecisionId).toBe(EXEC_DECISION_ID);
      expect(experience.opportunityId).toBe(OPPORTUNITY_ID);
      expect(experience.outcomeId).toBe("outcome-1");
      expect(experience.laneId).toBe("CG_WIDE_FAST_LONG");
      expect(experience.symbolOrBasketId).toBe("BTCUSDT");
    }
    const totalRejected = Object.values(result.rejected).reduce((a, b) => a + b, 0);
    expect(totalRejected).toBe(0);
  });

  it("preserves continuous fractional netR exactly, never rounding or binarizing it", () => {
    const outcome = validOutcome({ grossR: 0.173456, costR: 0.02, netR: 0.153456 });
    const result = buildFourBrainExecutiveExperiences([outcome], [validReview()], journalMap(validJournalRow()), POLICY);
    expect(result.experiences.length).toBeGreaterThan(0);
    for (const experience of result.experiences) expect(experience.netR).toBeCloseTo(0.153456, 9);
  });

  it("decodes the executive decisionId embedded in the deterministic executiveReviewId construction", () => {
    expect(executiveDecisionIdFromReviewId(EXECUTIVE_REVIEW_ID, OPPORTUNITY_ID)).toBe(EXEC_DECISION_ID);
    expect(executiveDecisionIdFromReviewId(EXECUTIVE_REVIEW_ID, "wrong-opportunity")).toBeNull();
    expect(executiveDecisionIdFromReviewId("not-the-right-shape", OPPORTUNITY_ID)).toBeNull();
  });

  const rejectionCase = (
    name: string,
    mutate: (ctx: { review: ExecutiveReviewRecord; outcome: ExecutiveReviewOutcome; journal: ExecutiveJournalRow }) => void,
    expectedReason: FourBrainEconomicRejectionReason,
  ) =>
    it(name, () => {
      const ctx = { review: validReview(), outcome: validOutcome(), journal: validJournalRow() };
      mutate(ctx);
      const result = buildFourBrainExecutiveExperiences([ctx.outcome], [ctx.review], journalMap(ctx.journal), POLICY);
      expect(result.experiences).toHaveLength(0);
      expect(result.rejected[expectedReason]).toBeGreaterThan(0);
    });

  describe("causality", () => {
    rejectionCase(
      "mismatched opportunity/outcome ownership is rejected",
      (ctx) => { ctx.outcome.opportunityId = "some-other-opportunity"; },
      "IDENTITY_MISMATCH",
    );
    rejectionCase(
      "wrong lane between review and outcome is rejected",
      (ctx) => { ctx.outcome.laneId = "CG_WIDE_FAST_SHORT"; },
      "IDENTITY_MISMATCH",
    );
    rejectionCase(
      "stale policy context is rejected (a different 4-tuple than the expected current one)",
      (ctx) => { ctx.outcome.fourBrainPolicyVersion = "executive/1"; },
      "STALE_POLICY_CONTEXT",
    );
    it("this source has no separate policyDeploymentAt cutover — staleness is instead fully covered by the exact 4-tuple match, so an old-era record is caught by STALE_POLICY_CONTEXT rather than a PRE_CUTOVER check that has no field to test against", () => {
      const outcome = validOutcome({ decisionPipelinePolicyVersion: "pipeline/v1" });
      const result = buildFourBrainExecutiveExperiences([outcome], [validReview()], journalMap(validJournalRow()), POLICY);
      expect(result.experiences).toHaveLength(0);
      expect(result.rejected.STALE_POLICY_CONTEXT).toBe(1);
      expect(result.rejected.PRE_CUTOVER).toBe(0);
    });
    it("a missing review for the outcome's executiveReviewId is rejected, not silently dropped", () => {
      const result = buildFourBrainExecutiveExperiences([validOutcome()], [], journalMap(validJournalRow()), POLICY);
      expect(result.experiences).toHaveLength(0);
      expect(result.rejected.MISSING_CAUSAL_IDENTITY).toBe(1);
    });
    it("intrabarAmbiguous is always false from this source (real exchange-settled fills, not a simulated candle-walk)", () => {
      const result = buildFourBrainExecutiveExperiences([validOutcome()], [validReview()], journalMap(validJournalRow()), POLICY);
      for (const experience of result.experiences) expect(experience.intrabarAmbiguous).toBe(false);
    });
  });

  describe("economic adapter", () => {
    rejectionCase(
      "missing immutable risk is rejected",
      (ctx) => { ctx.outcome.originalRisk = 0; },
      "MISSING_IMMUTABLE_RISK",
    );
    rejectionCase(
      "non-finite immutable risk is rejected",
      (ctx) => { ctx.outcome.originalRisk = Number.NaN; },
      "MISSING_IMMUTABLE_RISK",
    );
    rejectionCase(
      "incomplete settlement (missing required order ids) is rejected",
      (ctx) => { ctx.outcome.missingRequiredOrderIds = ["order-2"]; },
      "INCOMPLETE_COST",
    );
    rejectionCase(
      "negative canonical cost is rejected even if arithmetically self-consistent",
      (ctx) => { ctx.outcome.costR = -0.05; ctx.outcome.grossR = 0.4; ctx.outcome.netR = 0.45; },
      "INVALID_COST_CONVENTION",
    );
    rejectionCase(
      "an arithmetic mismatch between gross, cost, and net is rejected",
      (ctx) => { ctx.outcome.grossR = 1.0; ctx.outcome.costR = 0.05; ctx.outcome.netR = 0.9; },
      "ECONOMIC_ARITHMETIC_MISMATCH",
    );
    rejectionCase(
      "a resolvedAtMs before entryAtMs is rejected",
      (ctx) => { ctx.outcome.resolvedAtMs = ctx.outcome.entryAtMs - 1; },
      "INVALID_OUTCOME_QUALITY",
    );
    it("a missing feature snapshot (journal retention gap — no matching journal row at all) is rejected, not silently dropped", () => {
      const result = buildFourBrainExecutiveExperiences([validOutcome()], [validReview()], new Map(), POLICY);
      expect(result.experiences).toHaveLength(0);
      expect(result.rejected.MISSING_FEATURE_SNAPSHOT).toBe(1);
    });
    it("a journal row present but with neither normalizedFeatures nor rawFeatures is rejected the same way", () => {
      const journal = validJournalRow({ normalizedFeatures: null, rawFeatures: null });
      const result = buildFourBrainExecutiveExperiences([validOutcome()], [validReview()], journalMap(journal), POLICY);
      expect(result.experiences).toHaveLength(0);
      expect(result.rejected.MISSING_FEATURE_SNAPSHOT).toBe(1);
    });
    it("unresolved (no resolvedAtMs) is never counted as negative — it is its own distinct rejection", () => {
      const outcome = validOutcome({ resolvedAtMs: 0 as unknown as number });
      const result = buildFourBrainExecutiveExperiences([outcome], [validReview()], journalMap(validJournalRow()), POLICY);
      expect(result.experiences).toHaveLength(0);
      expect(result.rejected.UNRESOLVED).toBe(1);
      expect(result.rejected.ECONOMIC_ARITHMETIC_MISMATCH).toBe(0);
    });

    it("does not silently drop non-Tier-1 or non-eligible rows — SOURCE_ERROR is counted", () => {
      const tier2 = validOutcome({ tier: "TIER_2_COUNTERFACTUAL" as never });
      const result = buildFourBrainExecutiveExperiences([tier2], [validReview()], journalMap(validJournalRow()), POLICY);
      expect(result.experiences).toHaveLength(0);
      expect(result.rejected.SOURCE_ERROR).toBe(1);
    });

    it("a source-status ERROR anywhere in the joined journal row is rejected", () => {
      const journal = validJournalRow({ sourceStatuses: { trend: "ERROR" } });
      const result = buildFourBrainExecutiveExperiences([validOutcome()], [validReview()], journalMap(journal), POLICY);
      expect(result.experiences).toHaveLength(0);
      expect(result.rejected.SOURCE_ERROR).toBe(1);
    });
  });

  describe("brain-level attribution", () => {
    it("Market State only receives credit when its own decision object was present at the joined tick", () => {
      const journal = validJournalRow({ brains: { marketState: null, direction: { marketDirection: "LONG" }, entry: { action: "ENTER_NOW" }, exit: null } });
      const result = buildFourBrainExecutiveExperiences([validOutcome()], [validReview()], journalMap(journal), POLICY);
      const brains = result.experiences.map((e) => e.brain);
      expect(brains).not.toContain("MARKET_STATE");
      expect(brains).toContain("DIRECTION");
      expect(brains).toContain("ENTRY");
    });

    it("a lane-A outcome never produces an experience attributed to lane B", () => {
      const laneAJournal = validJournalRow({ decisionIds: { executive: "exec-a" }, laneId: "LANE_A" });
      const laneAReview = validReview({ executiveReviewId: "executive-review:exec-a:opp-a", opportunityId: "opp-a", laneId: "LANE_A" });
      const laneAOutcome = validOutcome({ executiveReviewId: "executive-review:exec-a:opp-a", opportunityId: "opp-a", laneId: "LANE_A" });
      const result = buildFourBrainExecutiveExperiences(
        [laneAOutcome],
        [laneAReview],
        journalMap({ ...laneAJournal, decisionId: "exec-a" }),
        POLICY,
      );
      expect(result.experiences.every((e) => e.laneId === "LANE_A")).toBe(true);
      expect(result.experiences.some((e) => e.laneId === "LANE_B")).toBe(false);
    });

    it("when the outcome itself is invalid (missing immutable risk), no brain gets any credit — not just Entry", () => {
      const outcome = validOutcome({ originalRisk: 0 });
      const result = buildFourBrainExecutiveExperiences([outcome], [validReview()], journalMap(validJournalRow()), POLICY);
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

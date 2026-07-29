import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ExecutiveReviewStore,
  eligibleTier1ExecutiveReview,
  executiveReviewTier1Aggregates,
  type ExecutiveReviewOutcome,
  type ExecutiveReviewOutcomeLink,
  type ExecutiveReviewPositionLink,
  type ExecutiveReviewRecord,
} from "../src/lib/executive-review-store.js";
import { markTerminalExecutiveReviewsTier2Only, resolveExecutiveReviewPositions } from "../src/lib/executive-review-runtime.js";
import type { LiveIntent } from "../src/lib/live-execution-engine.js";
import type { PaperOrder } from "../src/lib/paper-execution-router.js";

const review = (overrides: Partial<ExecutiveReviewRecord> = {}): ExecutiveReviewRecord => ({
  executiveReviewId: "review-1",
  candidateId: "candidate-1",
  opportunityId: "opportunity-1",
  laneId: "LANE",
  marketContextSnapshotId: "market-1",
  allocationSnapshotId: null,
  strategyAction: "ENTER",
  direction: "LONG",
  marketState: "BULLISH_TACTICAL",
  evidenceEra: "post-fix/1",
  advisoryVerdict: "VALID",
  advisoryOnly: true,
  reviewedAtMs: 100,
  sourceCutoffMs: 100,
  decisionPipelinePolicyVersion: "decision/1",
  executionPolicyVersion: "execution/1",
  evidencePolicyVersion: "evidence/1",
  fourBrainPolicyVersion: "four-brain/1",
  state: "PENDING_EXECUTION_LINK",
  reasonCode: null,
  positionId: null,
  outcomeId: null,
  ...overrides,
});

const position = (overrides: Partial<ExecutiveReviewPositionLink> = {}): ExecutiveReviewPositionLink => ({
  executiveReviewId: "review-1",
  candidateId: "candidate-1",
  opportunityId: "opportunity-1",
  executionIntentId: "intent-1",
  orderId: "order-1",
  positionId: "position-1",
  laneId: "LANE",
  marketContextSnapshotId: "market-1",
  entryAtMs: 110,
  originalRisk: 10,
  ambiguousOwnership: false,
  decisionPipelinePolicyVersion: "decision/1",
  executionPolicyVersion: "execution/1",
  evidencePolicyVersion: "evidence/1",
  fourBrainPolicyVersion: "four-brain/1",
  ...overrides,
});

const outcome = (overrides: Partial<ExecutiveReviewOutcomeLink> = {}): ExecutiveReviewOutcomeLink => ({
  executiveReviewId: "review-1",
  opportunityId: "opportunity-1",
  positionId: "position-1",
  outcomeId: "outcome-1",
  resolvedAtMs: 200,
  grossR: 0.25,
  costR: 0.05,
  executionCostKnown: true,
  executionCostProvenance: "EXCHANGE_MEASURED",
  settlementFetchComplete: true,
  requiredOrderIds: ["order-1", "exit-1"],
  matchedRequiredOrderIds: ["order-1", "exit-1"],
  missingRequiredOrderIds: [],
  netR: 0.2,
  decisionPipelinePolicyVersion: "decision/1",
  executionPolicyVersion: "execution/1",
  evidencePolicyVersion: "evidence/1",
  fourBrainPolicyVersion: "four-brain/1",
  completedCandle: true,
  ambiguousOwnership: false,
  ...overrides,
});

const tier1 = (): ExecutiveReviewOutcome => ({
  executiveReviewOutcomeId: "executive-review-outcome:review-1:position-1:outcome-1",
  executiveReviewId: "review-1",
  tier: "TIER_1_REAL",
  candidateId: "candidate-1",
  opportunityId: "opportunity-1",
  executionIntentId: "intent-1",
  orderId: "order-1",
  positionId: "position-1",
  outcomeId: "outcome-1",
  marketContextSnapshotId: "market-1",
  allocationSnapshotId: null,
  laneId: "LANE",
  direction: "LONG",
  marketState: "BULLISH_TACTICAL",
  evidenceEra: "post-fix/1",
  strategyAction: "ENTER",
  advisoryVerdict: "VALID",
  incumbentAction: "ENTERED",
  advisoryOnly: true,
  entryAtMs: 110,
  resolvedAtMs: 200,
  originalRisk: 10,
  grossR: 0.25,
  costR: 0.05,
  executionCostProvenance: "EXCHANGE_MEASURED",
  settlementFetchComplete: true,
  requiredOrderIds: ["order-1", "exit-1"],
  matchedRequiredOrderIds: ["order-1", "exit-1"],
  missingRequiredOrderIds: [],
  netR: 0.2,
  decisionPipelinePolicyVersion: "decision/1",
  executionPolicyVersion: "execution/1",
  evidencePolicyVersion: "evidence/1",
  fourBrainPolicyVersion: "four-brain/1",
  eligibleForFourBrainEvaluation: true,
  eligibleForCortexLearning: false,
});

describe("Executive Review Store", () => {
  it("requires an exact persisted lineage and resolves each review outcome once", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-"));
    try {
      const store = new ExecutiveReviewStore(join(dir, "reviews.json"));
      expect(store.addReview(review())).toBe(true);
      expect(store.resolve("review-1", position(), null)).toBe("POSITION_NOT_RESOLVED");
      expect(store.get().reviews[0]?.state).toBe("PENDING_OUTCOME");
      expect(store.resolve("review-1", position(), outcome())).toBeNull();
      expect(store.get().reviews[0]?.state).toBe("TIER1_ELIGIBLE");
      expect(store.get().tier1).toHaveLength(1);
      expect(store.resolve("review-1", position(), outcome())).toBe("EXECUTIVE_REVIEW_ALREADY_RESOLVED");
      expect(store.get().tier1).toHaveLength(1);
      expect(executiveReviewTier1Aggregates(store.get())).toContainEqual({
        dimension: "direction", key: "LONG", resolvedCount: 1, averageNetR: 0.2, positiveCount: 1, negativeCount: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed for ownership mismatch, missing explicit cost, and inconsistent net R", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-"));
    try {
      const store = new ExecutiveReviewStore(join(dir, "reviews.json"));
      expect(store.addReview(review())).toBe(true);
      expect(store.resolve("review-1", position({ candidateId: "other" }), null)).toBe("CANDIDATE_ID_MISMATCH");
      expect(store.get().reviews[0]?.state).toBe("REJECTED");

      expect(store.addReview(review({ executiveReviewId: "review-2", candidateId: "candidate-2", opportunityId: "opportunity-2" }))).toBe(true);
      const p2 = position({ executiveReviewId: "review-2", candidateId: "candidate-2", opportunityId: "opportunity-2", positionId: "position-2" });
      expect(store.resolve("review-2", p2, outcome({ executiveReviewId: "review-2", opportunityId: "opportunity-2", positionId: "position-2", executionCostKnown: false }))).toBe("EXECUTION_COST_MISSING");

      expect(store.addReview(review({ executiveReviewId: "review-3", candidateId: "candidate-3", opportunityId: "opportunity-3" }))).toBe(true);
      const p3 = position({ executiveReviewId: "review-3", candidateId: "candidate-3", opportunityId: "opportunity-3", positionId: "position-3" });
      expect(store.resolve("review-3", p3, outcome({ executiveReviewId: "review-3", opportunityId: "opportunity-3", positionId: "position-3", netR: 0.19 }))).toBe("NET_R_INVALID");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists pending state across restart and keeps Tier 2 separate until a deterministic resolver exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-"));
    try {
      const file = join(dir, "reviews.json");
      const first = new ExecutiveReviewStore(file);
      expect(first.addReview(review())).toBe(true);
      expect(first.resolve("review-1", position(), null)).toBe("POSITION_NOT_RESOLVED");
      first.save();
      const restored = new ExecutiveReviewStore(file);
      expect(restored.get().reviews[0]?.state).toBe("PENDING_OUTCOME");
      expect(restored.resolve("review-1", position(), outcome())).toBeNull();
      restored.save();
      const settled = new ExecutiveReviewStore(file);
      expect(settled.get().tier1).toHaveLength(1);
      expect(settled.resolve("review-1", position(), outcome())).toBe("EXECUTIVE_REVIEW_ALREADY_RESOLVED");

      expect(settled.addReview(review({ executiveReviewId: "review-2", candidateId: "candidate-2", opportunityId: "opportunity-2" }))).toBe(true);
      expect(settled.markTier2Only("review-2", "NO_REAL_POSITION")).toBeNull();
      expect(settled.get().reviews.find((r) => r.executiveReviewId === "review-2")?.state).toBe("TIER2_ONLY");
      expect(settled.get().tier2).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed direct rows instead of repairing their arithmetic", () => {
    expect(eligibleTier1ExecutiveReview(tier1())).toBe(true);
    expect(eligibleTier1ExecutiveReview({ ...tier1(), costR: Number.NaN })).toBe(false);
    expect(eligibleTier1ExecutiveReview({ ...tier1(), netR: 0.19 })).toBe(false);
    expect(eligibleTier1ExecutiveReview({ ...tier1(), outcomeId: "" })).toBe(false);
    expect(eligibleTier1ExecutiveReview({ ...tier1(), executionCostProvenance: null as never })).toBe(false);
  });

  it("accepts an explicit known-zero cost but rejects an unproven zero", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-"));
    try {
      const store = new ExecutiveReviewStore(join(dir, "reviews.json"));
      expect(store.addReview(review())).toBe(true);
      expect(store.resolve("review-1", position(), outcome({ costR: 0, netR: 0.25, executionCostProvenance: "EXCHANGE_MEASURED" }))).toBeNull();

      expect(store.addReview(review({ executiveReviewId: "review-2", candidateId: "candidate-2", opportunityId: "opportunity-2" }))).toBe(true);
      expect(store.resolve(
        "review-2",
        position({ executiveReviewId: "review-2", candidateId: "candidate-2", opportunityId: "opportunity-2", positionId: "position-2" }),
        outcome({ executiveReviewId: "review-2", opportunityId: "opportunity-2", positionId: "position-2", costR: 0, netR: 0.25, executionCostProvenance: null }),
      )).toBe("EXECUTION_COST_PROVENANCE_MISSING");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("moves an exact terminal no-fill paper opportunity to Tier 2 without manufacturing a result", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-"));
    try {
      const store = new ExecutiveReviewStore(join(dir, "reviews.json"));
      const record = review();
      expect(store.addReview(record)).toBe(true);
      const link = {
        executiveReviewId: record.executiveReviewId,
        candidateId: record.candidateId,
        opportunityId: record.opportunityId,
        laneId: record.laneId,
        marketContextSnapshotId: record.marketContextSnapshotId,
        allocationSnapshotId: record.allocationSnapshotId,
        direction: record.direction,
        marketState: record.marketState,
        evidenceEra: record.evidenceEra,
        decisionPipelinePolicyVersion: record.decisionPipelinePolicyVersion,
        executionPolicyVersion: record.executionPolicyVersion,
        evidencePolicyVersion: record.evidencePolicyVersion,
        fourBrainPolicyVersion: record.fourBrainPolicyVersion,
      };
      const expired = { paperOrderId: "paper-1", paperStatus: "PAPER_EXPIRED", executiveReviewLink: link } as PaperOrder;
      expect(markTerminalExecutiveReviewsTier2Only(store, [expired], new Set())).toEqual({ examined: 1, markedTier2Only: 1 });
      expect(store.get().reviews[0]?.state).toBe("TIER2_ONLY");
      expect(store.get().tier1).toHaveLength(0);
      expect(store.get().tier2).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never labels an active candle, then resolves only the later final-candle outcome", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-"));
    try {
      const store = new ExecutiveReviewStore(join(dir, "reviews.json"));
      expect(store.addReview(review())).toBe(true);
      expect(store.resolve("review-1", position(), outcome({ completedCandle: false }))).toBe("POSITION_NOT_RESOLVED");
      expect(store.get().reviews[0]?.state).toBe("PENDING_OUTCOME");
      expect(store.get().tier1).toHaveLength(0);
      expect(store.resolve("review-1", position(), outcome({ completedCandle: true, netR: 0.2 }))).toBeNull();
      expect(store.get().tier1).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("links only the exact persisted intent lineage and rejects a netted multi-review position", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-"));
    try {
      const store = new ExecutiveReviewStore(join(dir, "reviews.json"));
      const first = review();
      const second = review({ executiveReviewId: "review-2", candidateId: "candidate-2", opportunityId: "opportunity-2" });
      expect(store.addReview(first)).toBe(true);
      expect(store.addReview(second)).toBe(true);
      const firstLink = {
        executiveReviewId: first.executiveReviewId,
        candidateId: first.candidateId,
        opportunityId: first.opportunityId,
        laneId: first.laneId,
        marketContextSnapshotId: first.marketContextSnapshotId,
        allocationSnapshotId: first.allocationSnapshotId,
        direction: first.direction,
        marketState: first.marketState,
        evidenceEra: first.evidenceEra,
        decisionPipelinePolicyVersion: first.decisionPipelinePolicyVersion,
        executionPolicyVersion: first.executionPolicyVersion,
        evidencePolicyVersion: first.evidencePolicyVersion,
        fourBrainPolicyVersion: first.fourBrainPolicyVersion,
      };
      const secondLink = { ...firstLink, executiveReviewId: second.executiveReviewId, candidateId: second.candidateId, opportunityId: second.opportunityId };
      const intent = {
        paperOrderId: "paper-1",
        executionIntentId: "intent-1",
        positionId: "position-1",
        entryOrderId: "order-1",
        createdAt: new Date(110).toISOString(),
        effectiveRiskUsd: 10,
        originalRiskUsd: 10,
        executiveReviewLink: firstLink,
        sourcePaperOrders: [{ paperOrderId: "paper-1", laneId: "LANE", qty: 1, executiveReviewLink: firstLink }],
      } as LiveIntent;
      expect(resolveExecutiveReviewPositions(store, [intent]).linked).toBe(1);
      expect(store.get().reviews.find((r) => r.executiveReviewId === "review-1")?.state).toBe("PENDING_OUTCOME");
      expect(store.get().tier1).toHaveLength(0); // USD realization never invents a completed-candle R outcome.

      const netted = { ...intent, sourcePaperOrders: [{ paperOrderId: "paper-1", laneId: "LANE", qty: 1, executiveReviewLink: secondLink }] } as LiveIntent;
      expect(resolveExecutiveReviewPositions(store, [netted]).rejected).toBeGreaterThan(0);
      expect(store.get().reviews.find((r) => r.executiveReviewId === "review-1")?.state).toBe("REJECTED");
      expect(store.get().reviews.find((r) => r.executiveReviewId === "review-2")?.state).toBe("REJECTED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds one Tier 1 outcome only after a real close has a completed candle and explicit exchange fee", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-"));
    try {
      const store = new ExecutiveReviewStore(join(dir, "reviews.json"));
      const record = review();
      expect(store.addReview(record)).toBe(true);
      const link = {
        executiveReviewId: record.executiveReviewId,
        candidateId: record.candidateId,
        opportunityId: record.opportunityId,
        laneId: record.laneId,
        marketContextSnapshotId: record.marketContextSnapshotId,
        allocationSnapshotId: record.allocationSnapshotId,
        direction: record.direction,
        marketState: record.marketState,
        evidenceEra: record.evidenceEra,
        decisionPipelinePolicyVersion: record.decisionPipelinePolicyVersion,
        executionPolicyVersion: record.executionPolicyVersion,
        evidencePolicyVersion: record.evidencePolicyVersion,
        fourBrainPolicyVersion: record.fourBrainPolicyVersion,
      };
      const closed = {
        paperOrderId: "paper-1",
        executionIntentId: "intent-1",
        positionId: "position-1",
        entryOrderId: "order-1",
        createdAt: new Date(110).toISOString(),
        closedAt: new Date(1_000).toISOString(),
        state: "CLOSED",
        effectiveRiskUsd: 10,
        originalRiskUsd: 10,
        realizedPnlUsd: 2,
        feesUsd: 0,
        feeSource: "EXCHANGE",
        settlementFetchComplete: true,
        requiredOrderIds: ["order-1", "exit-1"],
        matchedRequiredOrderIds: ["order-1", "exit-1"],
        missingRequiredOrderIds: [],
        executiveReviewLink: link,
        sourcePaperOrders: [{ paperOrderId: "paper-1", laneId: "LANE", qty: 1, executiveReviewLink: link }],
      } as LiveIntent;
      // The close happens inside the 00:00–00:15 candle, so a 1ms-later resolver must wait.
      expect(resolveExecutiveReviewPositions(store, [closed], 1_001).linked).toBe(1);
      expect(store.get().tier1).toHaveLength(0);
      expect(resolveExecutiveReviewPositions(store, [closed], 900_000).linked).toBe(1);
      expect(store.get().tier1).toHaveLength(1);
      expect(store.get().tier1[0]).toMatchObject({ grossR: 0.2, costR: 0, netR: 0.2, executionCostProvenance: "EXCHANGE_MEASURED" });
      expect(resolveExecutiveReviewPositions(store, [closed], 900_000).linked).toBe(0);
      expect(store.get().tier1).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps incomplete exchange settlement out of Tier 1 while the position lifecycle resolves", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-incomplete-"));
    try {
      const store = new ExecutiveReviewStore(join(dir, "reviews.json"));
      expect(store.addReview(review())).toBe(true);
      const intent = {
        paperOrderId: "paper-1", executionIntentId: "intent-1", positionId: "position-1", entryOrderId: "order-1",
        createdAt: new Date(110).toISOString(), closedAt: new Date(1_000).toISOString(), state: "CLOSED",
        originalRiskUsd: 10, effectiveRiskUsd: 10, realizedPnlUsd: 2, feesUsd: 0, feeSource: "EXCHANGE",
        settlementFetchComplete: false, requiredOrderIds: ["order-1", "exit-1"], matchedRequiredOrderIds: ["exit-1"], missingRequiredOrderIds: ["order-1"],
        executiveReviewLink: {
          executiveReviewId: "review-1", candidateId: "candidate-1", opportunityId: "opportunity-1", laneId: "LANE",
          marketContextSnapshotId: "market-1", allocationSnapshotId: null, direction: "LONG", marketState: "BULLISH_TACTICAL", evidenceEra: "post-fix/1",
          decisionPipelinePolicyVersion: "decision/1", executionPolicyVersion: "execution/1", evidencePolicyVersion: "evidence/1", fourBrainPolicyVersion: "four-brain/1",
        },
      } as LiveIntent;
      resolveExecutiveReviewPositions(store, [intent], 900_000);
      expect(store.get().tier1).toHaveLength(0);
      expect(store.get().reviews[0]?.reasonCode).toBe("SETTLEMENT_INCOMPLETE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
